import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
  SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS,
  SANDBOX_EGRESS_FIREWALL_ERROR_CODES,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS,
  resolveSandboxEgressMinimumSchema,
  sandboxEgressAttestationPayloadBytes,
  verifySandboxEgressAttestation,
  verifySandboxEgressAuthority,
  type SandboxEgressAttestationPayload,
} from "./sandbox-egress-attestation.js";

const APP = "mendpoint-sandbox";
const IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
const POLICY = `sha256:${"b".repeat(64)}`;
const NOW = "2026-08-18T20:00:00.000Z";

function signed(overrides: Partial<SandboxEgressAttestationPayload> = {}) {
  const keys = generateKeyPairSync("ed25519");
  const payload: SandboxEgressAttestationPayload = {
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app: APP,
    image: IMAGE,
    policyDigest: POLICY,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: "2026-08-18T20:55:00.000Z",
    forbiddenOutbound: {
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
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

  it("binds the signed receipt to the exact multi-target forbidden probe", () => {
    const fixture = signed();
    expect(fixture.payload.forbiddenOutbound).toEqual({
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
      blocked: true,
    });
    expect(() => sandboxEgressAttestationPayloadBytes({
      ...fixture.payload,
      forbiddenOutbound: {
        ...fixture.payload.forbiddenOutbound,
        commandDigest: `sha256:${"f".repeat(64)}`,
      },
    })).toThrow("sandbox_egress_attestation_probe_invalid");
  });

  it("rejects a legacy v1 receipt for every MIN_SCHEMA input (unset, blank, v1, v2): the floor is code, not input", () => {
    const keys = generateKeyPairSync("ed25519");
    const legacyPayload = {
      schemaVersion: SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
      app: APP,
      image: IMAGE,
      policyDigest: POLICY,
      testedAt: "2026-08-18T19:55:00.000Z",
      expiresAt: "2026-08-18T20:55:00.000Z",
      forbiddenOutbound: { url: "https://example.com/", blocked: true },
      allowedVerification: { commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true },
      evidenceRefs: ["evidence://protected-egress-acceptance/legacy"],
    };
    const payloadBytes = Buffer.from(JSON.stringify(legacyPayload), "utf8");
    const config = {
      attestationBase64: Buffer.from(JSON.stringify({
        payload: payloadBytes.toString("base64"),
        signatures: [{
          keyId: "sandbox-egress-key-1",
          signature: sign(null, payloadBytes, keys.privateKey).toString("base64"),
        }],
      }), "utf8").toString("base64"),
      publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      expectedKeyId: "sandbox-egress-key-1",
      expectedPolicyDigest: POLICY,
      expectedApp: APP,
      expectedImage: IMAGE,
      observedAt: NOW,
    };
    // The unsound legacy probe (fetch/example.com) is below the code floor. Unset, blank,
    // and a v1 input all keep the code floor (below-floor does not lower), and requiring
    // v2 also rejects it. There is no input that accepts a legacy receipt.
    for (const minimumSchemaVersion of [
      undefined,
      "",
      "  ",
      SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
      SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    ]) {
      expect(() => verifySandboxEgressAttestation({ ...config, minimumSchemaVersion }))
        .toThrow("sandbox_egress_attestation_schema_invalid");
    }
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
    const fakeProcess = {
      stdout: { write: (_value: string) => true },
      exit: (code: number) => resolve(code),
    };
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
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app: APP,
    image: IMAGE,
    policyDigest: POLICY,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: "2026-08-18T20:55:00.000Z",
    forbiddenOutbound: {
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
      blocked: false,
    },
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

describe("schema floor is a code policy, raised-only by config (finding 1)", () => {
  it("is the strongest known schema version, so unset/blank resolves to it and rejects legacy", () => {
    const versions = SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS;
    expect(SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR).toBe(SANDBOX_EGRESS_ATTESTATION_SCHEMA);
    expect(versions[versions.length - 1]).toBe(SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR);
    // A blank or unset value means "use the code floor", never "accept anything".
    for (const configured of [undefined, "", "   "]) {
      expect(resolveSandboxEgressMinimumSchema(configured)).toBe(SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR);
    }
  });

  it("an env value BELOW the code floor does not lower it", () => {
    expect(resolveSandboxEgressMinimumSchema(SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA))
      .toBe(SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR);
  });

  it("an env value ABOVE the code floor does raise it", () => {
    // With the real two-version ordering v2 is the top; a value outranking a (lower)
    // floor raises the requirement to that value.
    expect(
      resolveSandboxEgressMinimumSchema(SANDBOX_EGRESS_ATTESTATION_SCHEMA, {
        floor: SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
      }),
    ).toBe(SANDBOX_EGRESS_ATTESTATION_SCHEMA);
    // Forward-looking: once a newer schema is appended to the ordering, configuring it
    // raises the floor above the current code floor.
    const FUTURE = "2026-09-01.v3";
    expect(
      resolveSandboxEgressMinimumSchema(FUTURE, {
        versions: [...SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS, FUTURE],
      }),
    ).toBe(FUTURE);
  });

  it("a non-empty value that is not a known schema version fails closed with config_invalid", () => {
    expect(() => resolveSandboxEgressMinimumSchema("nonsense"))
      .toThrow("sandbox_egress_attestation_config_invalid");
  });
});

describe("acceptance verification sources expected values independent of the receipt (finding 3)", () => {
  it("the workflow never threads the receipt's own key id, policy digest, or schema into the expected values", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../../../.github/workflows/sandbox-egress-acceptance.yml", import.meta.url),
      ),
      "utf8",
    );
    // A receipt vouching for itself can never mismatch: these tautological bindings must
    // be gone.
    expect(workflow).not.toContain("expectedKeyId: receipt.keyId");
    expect(workflow).not.toContain("expectedPolicyDigest: receipt.policyDigest");
    expect(workflow).not.toContain("minimumSchemaVersion: receipt.payload.schemaVersion");
    // The trusted key id and policy digest come from the configured production authority;
    // the schema floor comes from platform code.
    expect(workflow).toContain("expectedKeyId: process.env.MENDPOINT_SANDBOX_EGRESS_KEY_ID");
    expect(workflow).toContain(
      "expectedPolicyDigest: process.env.MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST",
    );
    expect(workflow).toContain("minimumSchemaVersion: SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR");
  });

  it("a configured trusted key id that differs from the receipt's self-declared key id is a reachable rejection", () => {
    const fixture = signed();
    // The receipt signs itself under keyId "sandbox-egress-key-1". An independent trusted
    // key id (what the workflow reads from configured vars) that differs must reject,
    // proving the branch is not a self-satisfied tautology.
    expect(() =>
      verifySandboxEgressAttestation({
        ...fixture.config,
        expectedKeyId: "configured-trusted-key-id",
        expectedApp: APP,
        expectedImage: IMAGE,
        observedAt: NOW,
      }),
    ).toThrow("sandbox_egress_attestation_signature_invalid");
  });

  it("a configured policy digest that differs from the receipt's self-bound digest is a reachable rejection", () => {
    const fixture = signed();
    expect(() =>
      verifySandboxEgressAttestation({
        ...fixture.config,
        expectedPolicyDigest: `sha256:${"e".repeat(64)}`,
        expectedApp: APP,
        expectedImage: IMAGE,
        observedAt: NOW,
      }),
    ).toThrow("sandbox_egress_attestation_scope_mismatch");
  });
});

describe("verifySandboxEgressAuthority (file-first resolver)", () => {
  const basePayload = {
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app: APP,
    image: IMAGE,
    policyDigest: POLICY,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: "2026-08-18T20:55:00.000Z",
    forbiddenOutbound: {
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
      blocked: true,
    },
    allowedVerification: {
      commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
      passed: true,
    },
    evidenceRefs: ["evidence://protected-egress-acceptance/1"],
  } satisfies SandboxEgressAttestationPayload;

  // A single Ed25519 key signs both candidates so the ONE configured public key
  // can verify either -- the wrapper's job is to choose the source, not the key.
  function makeAuthority() {
    const keys = generateKeyPairSync("ed25519");
    const publicKeySpkiBase64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const attestation = (
      overrides: Partial<SandboxEgressAttestationPayload> = {},
      opts: { wrongKey?: boolean } = {},
    ): string => {
      const payload = { ...basePayload, ...overrides } as SandboxEgressAttestationPayload;
      const payloadBytes = sandboxEgressAttestationPayloadBytes(payload);
      const signingKey = opts.wrongKey ? generateKeyPairSync("ed25519").privateKey : keys.privateKey;
      const envelope = {
        payload: payloadBytes.toString("base64"),
        signatures: [{ keyId: "sandbox-egress-key-1", signature: sign(null, payloadBytes, signingKey).toString("base64") }],
      };
      return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    };
    return { publicKeySpkiBase64, attestation };
  }

  function config(publicKeySpkiBase64: string) {
    return {
      publicKeySpkiBase64,
      expectedKeyId: "sandbox-egress-key-1",
      expectedPolicyDigest: POLICY,
      expectedApp: APP,
      expectedImage: IMAGE,
      observedAt: NOW,
    };
  }

  const EXPIRED = { testedAt: "2026-08-18T18:00:00.000Z", expiresAt: "2026-08-18T19:00:00.000Z" } as const;

  function tmpFile(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "egress-authority-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  // Symlink creation needs privilege on some Windows hosts; probe once so the
  // symlink case runs on CI (Linux) and is skipped only where it cannot be set up.
  let canSymlink = false;
  try {
    const probe = mkdtempSync(join(tmpdir(), "egress-symlink-probe-"));
    writeFileSync(join(probe, "target"), "x");
    symlinkSync(join(probe, "target"), join(probe, "link"));
    canSymlink = true;
  } catch {
    canSymlink = false;
  }

  it("prefers the file candidate when it verifies (source: file)", () => {
    const authority = makeAuthority();
    const path = tmpFile("attestation.b64", authority.attestation());
    const result = verifySandboxEgressAuthority({
      ...config(authority.publicKeySpkiBase64),
      attestationBase64: authority.attestation(),
      attestationPath: path,
    });
    expect(result.source).toBe("file");
    expect(result.payload).toMatchObject({ app: APP, image: IMAGE, policyDigest: POLICY });
  });

  it("falls back to the environment when the file is present but tampered (source: env)", () => {
    const authority = makeAuthority();
    const path = tmpFile("attestation.b64", authority.attestation({}, { wrongKey: true }));
    const result = verifySandboxEgressAuthority({
      ...config(authority.publicKeySpkiBase64),
      attestationBase64: authority.attestation(),
      attestationPath: path,
    });
    expect(result.source).toBe("env");
  });

  it("uses the environment when the file is missing (source: env)", () => {
    const authority = makeAuthority();
    const missing = join(mkdtempSync(join(tmpdir(), "egress-missing-")), "absent.b64");
    const result = verifySandboxEgressAuthority({
      ...config(authority.publicKeySpkiBase64),
      attestationBase64: authority.attestation(),
      attestationPath: missing,
    });
    expect(result.source).toBe("env");
  });

  it.skipIf(!canSymlink)("refuses a symlinked attestation path (file error surfaced when the environment cannot cover)", () => {
    const authority = makeAuthority();
    const dir = mkdtempSync(join(tmpdir(), "egress-symlink-"));
    const target = join(dir, "real.b64");
    writeFileSync(target, authority.attestation());
    const link = join(dir, "attestation.b64");
    symlinkSync(target, link);
    expect(() =>
      verifySandboxEgressAuthority({
        ...config(authority.publicKeySpkiBase64),
        attestationBase64: undefined,
        attestationPath: link,
      }),
    ).toThrow("sandbox_egress_attestation_file_symlink");
  });

  it("refuses an oversize attestation file (file error surfaced when the environment cannot cover)", () => {
    const authority = makeAuthority();
    const path = tmpFile("attestation.b64", "A".repeat(40 * 1024));
    expect(() =>
      verifySandboxEgressAuthority({
        ...config(authority.publicKeySpkiBase64),
        attestationBase64: undefined,
        attestationPath: path,
      }),
    ).toThrow("sandbox_egress_attestation_file_too_large");
  });

  it("falls back to a fresh environment receipt when the file receipt is expired (source: env)", () => {
    const authority = makeAuthority();
    const path = tmpFile("attestation.b64", authority.attestation(EXPIRED));
    const result = verifySandboxEgressAuthority({
      ...config(authority.publicKeySpkiBase64),
      attestationBase64: authority.attestation(),
      attestationPath: path,
    });
    expect(result.source).toBe("env");
  });

  it("throws the file's error (not the environment's) when neither candidate verifies", () => {
    const authority = makeAuthority();
    // The file candidate's error is expiry; the environment candidate's is a bad
    // signature. The file's error must win, proving a present-but-bad file is
    // surfaced rather than masked by the environment's failure.
    const path = tmpFile("attestation.b64", authority.attestation(EXPIRED));
    expect(() =>
      verifySandboxEgressAuthority({
        ...config(authority.publicKeySpkiBase64),
        attestationBase64: authority.attestation({}, { wrongKey: true }),
        attestationPath: path,
      }),
    ).toThrow("sandbox_egress_attestation_expired");
  });

  // S2: on total failure the resolver must prefer an authentic-but-expired
  // ENVIRONMENT receipt so the worker boot handler degrades rather than
  // crash-loops the single production machine on an unrelated file corruption.
  describe("total-failure preference degrades on an authentic-but-expired environment receipt (S2)", () => {
    it("fresh environment receipt + bad file → environment is used (no throw)", () => {
      const authority = makeAuthority();
      const path = tmpFile("attestation.b64", authority.attestation({}, { wrongKey: true }));
      const result = verifySandboxEgressAuthority({
        ...config(authority.publicKeySpkiBase64),
        attestationBase64: authority.attestation(),
        attestationPath: path,
      });
      expect(result.source).toBe("env");
    });

    it("expired environment receipt + expired file → throws expired (boot can degrade)", () => {
      const authority = makeAuthority();
      const path = tmpFile("attestation.b64", authority.attestation(EXPIRED));
      expect(() =>
        verifySandboxEgressAuthority({
          ...config(authority.publicKeySpkiBase64),
          attestationBase64: authority.attestation(EXPIRED),
          attestationPath: path,
        }),
      ).toThrow("sandbox_egress_attestation_expired");
    });

    it("expired environment receipt + oversize file → throws expired and surfaces the file failure code", () => {
      const authority = makeAuthority();
      const path = tmpFile("attestation.b64", "A".repeat(40 * 1024));
      let thrown: unknown;
      try {
        verifySandboxEgressAuthority({
          ...config(authority.publicKeySpkiBase64),
          attestationBase64: authority.attestation(EXPIRED),
          attestationPath: path,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("sandbox_egress_attestation_expired");
      // The file's own failure code is surfaced so an operator sees the file is unusable.
      expect((thrown as { fileCandidateError?: string }).fileCandidateError).toBe(
        "sandbox_egress_attestation_file_too_large",
      );
    });

    it("both candidates invalid (neither expired) → throws the file's error (fatal at boot)", () => {
      const authority = makeAuthority();
      // File oversize (a file-only code) + environment bad signature: neither is the
      // authentic-but-expired case, so the file's error wins and boot stays fatal.
      const path = tmpFile("attestation.b64", "A".repeat(40 * 1024));
      expect(() =>
        verifySandboxEgressAuthority({
          ...config(authority.publicKeySpkiBase64),
          attestationBase64: authority.attestation({}, { wrongKey: true }),
          attestationPath: path,
        }),
      ).toThrow("sandbox_egress_attestation_file_too_large");
    });
  });
});
