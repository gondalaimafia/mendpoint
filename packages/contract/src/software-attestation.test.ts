import {
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DSSE_IN_TOTO_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_V1,
  MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1,
  SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES,
  canonicalSoftwareAttestationStatementJson,
  createSoftwareAttestationStatementV1,
  dssePreAuthEncode,
  signSoftwareAttestation,
  verifySoftwareAttestation,
  type DsseEnvelope,
  type SoftwareAttestationExpectedScope,
  type SoftwareAttestationSigner,
  type SoftwareAttestationStatementInput,
  type SoftwareAttestationTrustedKey,
  type SoftwareAttestationTrustPolicy,
} from "./software-attestation.js";

const issuedAt = "2026-08-12T12:00:00.000Z";
const verifiedAt = "2026-08-12T12:05:00.000Z";
const digest = (character: string): string => character.repeat(64);

function statementInput(): SoftwareAttestationStatementInput {
  return {
    attestationId: "attestation-1",
    scope: {
      tenantId: "tenant-a",
      repositoryId: "github:gondalaimafia/mendpoint-canary-drill-20260801",
      runId: "run-1",
      correlationId: "change-1",
      sourceArtifacts: [
        { artifactId: "source-b", sha256: digest("b") },
        { artifactId: "source-a", sha256: digest("a") },
      ],
      snapshotArtifact: { artifactId: "snapshot-1", sha256: digest("c") },
      candidateArtifact: { artifactId: "candidate-1", sha256: digest("d") },
      verificationArtifacts: [
        { artifactId: "verification-b", sha256: digest("f") },
        { artifactId: "verification-a", sha256: digest("e") },
      ],
      policyArtifact: { artifactId: "policy-1", sha256: digest("1") },
      deliveryArtifact: { artifactId: "delivery-1", sha256: digest("2") },
      rollbackArtifact: { artifactId: "rollback-1", sha256: digest("3") },
      waiverArtifact: null,
    },
    producer: {
      principalId: "service:warden",
      service: "warden-pipeline",
      version: "1.0.0",
    },
    outcome: "passed",
    issuedAt,
  };
}

function expectedScope(): SoftwareAttestationExpectedScope {
  return structuredClone(statementInput().scope);
}

function cryptoFixture(options: { revokedAt?: string | null } = {}): {
  privateKey: KeyObject;
  signer: SoftwareAttestationSigner;
  trustPolicy: SoftwareAttestationTrustPolicy;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    signer: {
      keyId: "warden-attestation-key-1",
      algorithm: "ed25519",
      async sign(bytes) {
        return signBytes(null, bytes, privateKey);
      },
    },
    trustPolicy: {
      async resolve(keyId) {
        if (keyId !== "warden-attestation-key-1") return null;
        return {
          keyId,
          algorithm: "ed25519",
          publicKey,
          principalId: "service:warden",
          service: "warden-pipeline",
          tenantIds: ["tenant-a"],
          predicateTypes: [MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1],
          validFrom: "2026-08-12T11:00:00.000Z",
          validUntil: "2026-08-12T13:00:00.000Z",
          revokedAt: options.revokedAt ?? null,
        };
      },
    },
  };
}

function signedEnvelopeForPayload(payload: Uint8Array, privateKey: KeyObject): DsseEnvelope {
  const signature = signBytes(
    null,
    dssePreAuthEncode(DSSE_IN_TOTO_PAYLOAD_TYPE, payload),
    privateKey,
  );
  return {
    payloadType: DSSE_IN_TOTO_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [{ keyid: "warden-attestation-key-1", sig: signature.toString("base64") }],
  };
}

function toUrlSafeBase64(value: string): string {
  return value.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

describe("formal software attestation contract", () => {
  it("creates a deterministic in-toto statement bound to the exact software scope", () => {
    const input = statementInput();
    const reordered = statementInput();
    reordered.scope.sourceArtifacts.reverse();
    reordered.scope.verificationArtifacts.reverse();

    const statement = createSoftwareAttestationStatementV1(input);
    const equivalent = createSoftwareAttestationStatementV1(reordered);

    expect(statement).toMatchObject({
      _type: IN_TOTO_STATEMENT_V1,
      predicateType: MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1,
      subject: [{
        name: "candidate-1",
        digest: { sha256: digest("d") },
      }],
      predicate: {
        schemaVersion: 1,
        attestationId: "attestation-1",
        scope: {
          tenantId: "tenant-a",
          sourceArtifacts: [
            { artifactId: "source-a", sha256: digest("a") },
            { artifactId: "source-b", sha256: digest("b") },
          ],
        },
      },
    });
    expect(canonicalSoftwareAttestationStatementJson(statement)).toBe(
      canonicalSoftwareAttestationStatementJson(equivalent),
    );
    expect(Object.isFrozen(statement)).toBe(true);
    expect(Object.isFrozen(statement.predicate.scope.sourceArtifacts)).toBe(true);

    input.scope.sourceArtifacts[0]!.artifactId = "mutated";
    expect(statement.predicate.scope.sourceArtifacts[0]!.artifactId).toBe("source-a");
  });

  it("implements the DSSE v1 pre-authentication encoding over byte lengths", () => {
    expect(
      Buffer.from(dssePreAuthEncode("text/plain", Buffer.from("hi"))).toString("utf8"),
    ).toBe("DSSEv1 10 text/plain 2 hi");
    expect(
      Buffer.from(dssePreAuthEncode("text/plain", Buffer.from("\u00e9"))).toString("utf8"),
    ).toBe("DSSEv1 10 text/plain 2 \u00e9");
  });

  it("uses locale-independent code-unit ordering for authenticated artifact arrays", () => {
    const input = statementInput();
    input.scope.sourceArtifacts = [
      { artifactId: "a-source", sha256: digest("a") },
      { artifactId: "Z-source", sha256: digest("b") },
    ];
    expect(
      createSoftwareAttestationStatementV1(input).predicate.scope.sourceArtifacts.map(
        (item) => item.artifactId,
      ),
    ).toEqual(["Z-source", "a-source"]);
  });

  it("signs with an injected Ed25519 signer and verifies before returning a frozen statement", async () => {
    const { signer, trustPolicy } = cryptoFixture();
    const statement = createSoftwareAttestationStatementV1(statementInput());
    const envelope = await signSoftwareAttestation(statement, signer);

    const verified = await verifySoftwareAttestation({
      envelope,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    });

    expect(envelope.payloadType).toBe(DSSE_IN_TOTO_PAYLOAD_TYPE);
    expect(envelope.signatures).toHaveLength(1);
    expect(verified.statement).toEqual(statement);
    expect(verified.key).toEqual({
      keyId: "warden-attestation-key-1",
      principalId: "service:warden",
      service: "warden-pipeline",
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.signatures)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.statement.predicate.scope)).toBe(true);
  });

  it("accepts canonical standard and URL-safe Base64 payloads and signatures", async () => {
    const fixture = cryptoFixture();
    const standard = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      fixture.signer,
    );
    const urlSafe = {
      ...standard,
      payload: toUrlSafeBase64(standard.payload),
      signatures: standard.signatures.map((entry) => ({
        ...entry,
        sig: toUrlSafeBase64(entry.sig),
      })),
    } satisfies DsseEnvelope;

    await expect(verifySoftwareAttestation({
      envelope: urlSafe,
      trustPolicy: fixture.trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).resolves.toMatchObject({ statement: { predicate: { attestationId: "attestation-1" } } });
  });

  it("ignores authenticated extension fields in the envelope, signature, Statement, and predicate", async () => {
    const fixture = cryptoFixture();
    const statement = structuredClone(
      createSoftwareAttestationStatementV1(statementInput()),
    ) as unknown as Record<string, unknown> & { predicate: Record<string, unknown> };
    statement["x-mendpoint-statement"] = { version: 1 };
    statement.predicate["x-mendpoint-predicate"] = "preserved-by-signature";
    const payload = Buffer.from(JSON.stringify(statement), "utf8");
    const envelope = signedEnvelopeForPayload(payload, fixture.privateKey) as unknown as {
      payloadType: typeof DSSE_IN_TOTO_PAYLOAD_TYPE;
      payload: string;
      signatures: Array<{ keyid: string; sig: string; extension?: string }>;
      extension?: string;
    };
    envelope.extension = "ignored";
    envelope.signatures[0]!.extension = "ignored";

    await expect(verifySoftwareAttestation({
      envelope,
      trustPolicy: fixture.trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).resolves.toMatchObject({ statement: { predicate: { attestationId: "attestation-1" } } });
  });

  it.each(["absent", "empty"] as const)(
    "verifies a signature with %s keyid by consulting trusted candidates",
    async (kind) => {
      const fixture = cryptoFixture();
      const envelope = await signSoftwareAttestation(
        createSoftwareAttestationStatementV1(statementInput()),
        fixture.signer,
      );
      const signature = { sig: envelope.signatures[0]!.sig } as { keyid?: string; sig: string };
      if (kind === "empty") signature.keyid = "";
      const withoutHint = { ...envelope, signatures: [signature] } as DsseEnvelope;
      const trusted = await fixture.trustPolicy.resolve!("warden-attestation-key-1");
      const trustPolicy: SoftwareAttestationTrustPolicy = {
        candidates: async () => [trusted!],
      } as SoftwareAttestationTrustPolicy;

      await expect(verifySoftwareAttestation({
        envelope: withoutHint,
        trustPolicy,
        expectedScope: expectedScope(),
        verifiedAt,
      })).resolves.toMatchObject({ key: { keyId: "warden-attestation-key-1" } });
    },
  );

  it("supports any-valid and explicit threshold verification over unique trusted keys", async () => {
    const first = cryptoFixture();
    const secondPair = generateKeyPairSync("ed25519");
    const statement = createSoftwareAttestationStatementV1(statementInput());
    const envelope = await signSoftwareAttestation(statement, first.signer);
    const payload = Buffer.from(envelope.payload, "base64");
    const preAuth = dssePreAuthEncode(DSSE_IN_TOTO_PAYLOAD_TYPE, payload);
    const secondSignature = signBytes(null, preAuth, secondPair.privateKey).toString("base64");
    const brokenSignature = Buffer.alloc(64).toString("base64");
    const multi = {
      ...envelope,
      signatures: [
        { keyid: "unknown", sig: brokenSignature },
        { keyid: "warden-attestation-key-1", sig: envelope.signatures[0]!.sig },
        { keyid: "warden-attestation-key-2", sig: secondSignature },
      ],
    } satisfies DsseEnvelope;
    const firstKey = (await first.trustPolicy.resolve!("warden-attestation-key-1"))!;
    const secondKey: SoftwareAttestationTrustedKey = {
      ...firstKey,
      keyId: "warden-attestation-key-2",
      publicKey: secondPair.publicKey,
    };
    const trustPolicy: SoftwareAttestationTrustPolicy = {
      threshold: 2,
      async resolve(keyId) {
        if (keyId === firstKey.keyId) return firstKey;
        if (keyId === secondKey.keyId) return secondKey;
        return null;
      },
      async candidates() {
        return [firstKey, secondKey];
      },
    };

    await expect(verifySoftwareAttestation({
      envelope: multi,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).resolves.toMatchObject({ keys: [{ keyId: firstKey.keyId }, { keyId: secondKey.keyId }] });

    const duplicated = {
      ...multi,
      signatures: [multi.signatures[1]!, multi.signatures[1]!],
    } satisfies DsseEnvelope;
    await expect(verifySoftwareAttestation({
      envelope: duplicated,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_signature_threshold_not_met");

    const aliasedKey: SoftwareAttestationTrustedKey = {
      ...firstKey,
      keyId: "warden-attestation-key-alias",
    };
    const aliasedEnvelope = {
      ...multi,
      signatures: [
        multi.signatures[1]!,
        { keyid: aliasedKey.keyId, sig: multi.signatures[1]!.sig },
      ],
    } satisfies DsseEnvelope;
    const aliasedTrust: SoftwareAttestationTrustPolicy = {
      threshold: 2,
      async resolve(keyId) {
        if (keyId === firstKey.keyId) return firstKey;
        if (keyId === aliasedKey.keyId) return aliasedKey;
        return null;
      },
    };
    await expect(verifySoftwareAttestation({
      envelope: aliasedEnvelope,
      trustPolicy: aliasedTrust,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_signature_threshold_not_met");

    let rotatingResolveCalls = 0;
    const rotatingEnvelope = {
      ...multi,
      signatures: [
        { keyid: "rotating-key", sig: multi.signatures[1]!.sig },
        { keyid: "rotating-key", sig: multi.signatures[2]!.sig },
      ],
    } satisfies DsseEnvelope;
    const rotatingTrust: SoftwareAttestationTrustPolicy = {
      threshold: 2,
      async resolve() {
        rotatingResolveCalls += 1;
        return rotatingResolveCalls === 1
          ? { ...firstKey, keyId: "rotating-key" }
          : { ...secondKey, keyId: "rotating-key" };
      },
    };
    await expect(verifySoftwareAttestation({
      envelope: rotatingEnvelope,
      trustPolicy: rotatingTrust,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_signature_threshold_not_met");
    expect(rotatingResolveCalls).toBe(1);

    await expect(verifySoftwareAttestation({
      envelope: { ...multi, signatures: multi.signatures.slice(0, 2) },
      trustPolicy: { ...trustPolicy, threshold: 1 },
      expectedScope: expectedScope(),
      verifiedAt,
    })).resolves.toMatchObject({ key: { keyId: firstKey.keyId } });
  });

  it("rejects payload tampering at signature verification before attempting JSON parsing", async () => {
    const { signer, trustPolicy } = cryptoFixture();
    const envelope = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      signer,
    );
    const tampered: DsseEnvelope = {
      ...envelope,
      payload: Buffer.from("not-json", "utf8").toString("base64"),
    };

    await expect(verifySoftwareAttestation({
      envelope: tampered,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_signature_invalid");
  });

  it.each([
    ["tenant", (scope: SoftwareAttestationExpectedScope) => { scope.tenantId = "tenant-b"; }],
    ["repository", (scope: SoftwareAttestationExpectedScope) => { scope.repositoryId = "github:other/repo"; }],
    ["run", (scope: SoftwareAttestationExpectedScope) => { scope.runId = "run-2"; }],
    ["correlation", (scope: SoftwareAttestationExpectedScope) => { scope.correlationId = "change-2"; }],
    ["source", (scope: SoftwareAttestationExpectedScope) => { scope.sourceArtifacts[0]!.sha256 = digest("9"); }],
    ["snapshot", (scope: SoftwareAttestationExpectedScope) => { scope.snapshotArtifact.sha256 = digest("9"); }],
    ["candidate", (scope: SoftwareAttestationExpectedScope) => { scope.candidateArtifact.sha256 = digest("9"); }],
    ["verification", (scope: SoftwareAttestationExpectedScope) => { scope.verificationArtifacts[0]!.sha256 = digest("9"); }],
    ["policy", (scope: SoftwareAttestationExpectedScope) => { scope.policyArtifact.sha256 = digest("9"); }],
    ["delivery", (scope: SoftwareAttestationExpectedScope) => { scope.deliveryArtifact!.sha256 = digest("9"); }],
    ["rollback", (scope: SoftwareAttestationExpectedScope) => { scope.rollbackArtifact!.sha256 = digest("9"); }],
  ])("rejects an otherwise valid envelope used for the wrong %s scope", async (_name, mutate) => {
    const { signer, trustPolicy } = cryptoFixture();
    const envelope = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      signer,
    );
    const expected = expectedScope();
    mutate(expected);
    await expect(verifySoftwareAttestation({
      envelope,
      trustPolicy,
      expectedScope: expected,
      verifiedAt,
    })).rejects.toThrow("software_attestation_scope_mismatch");
  });

  it("fails closed for untrusted, unauthorized, expired, and revoked signing keys", async () => {
    const fixture = cryptoFixture();
    const envelope = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      fixture.signer,
    );
    const unknown: SoftwareAttestationTrustPolicy = { resolve: async () => null };
    await expect(verifySoftwareAttestation({ envelope, trustPolicy: unknown, expectedScope: expectedScope(), verifiedAt }))
      .rejects.toThrow("software_attestation_key_untrusted");

    const denied: SoftwareAttestationTrustPolicy = {
      resolve: async (keyId) => ({
        ...(await fixture.trustPolicy.resolve!(keyId))!,
        tenantIds: ["tenant-b"],
      }),
    };
    await expect(verifySoftwareAttestation({ envelope, trustPolicy: denied, expectedScope: expectedScope(), verifiedAt }))
      .rejects.toThrow("software_attestation_key_unauthorized");

    await expect(verifySoftwareAttestation({
      envelope,
      trustPolicy: fixture.trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt: "2026-08-12T13:00:00.000Z",
    })).rejects.toThrow("software_attestation_key_expired");

    const revoked = cryptoFixture({ revokedAt: "2026-08-12T12:01:00.000Z" });
    const revokedEnvelope = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      revoked.signer,
    );
    await expect(verifySoftwareAttestation({
      envelope: revokedEnvelope,
      trustPolicy: revoked.trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_key_revoked");
  });

  it("rejects malformed, duplicate, and oversized data before signing or trust", async () => {
    const duplicate = statementInput();
    duplicate.scope.sourceArtifacts[1] = { ...duplicate.scope.sourceArtifacts[0]! };
    expect(() => createSoftwareAttestationStatementV1(duplicate)).toThrow(
      "software_attestation_artifact_duplicate",
    );

    const { trustPolicy } = cryptoFixture();
    const resolve = vi.spyOn(trustPolicy, "resolve");
    const oversized: DsseEnvelope = {
      payloadType: DSSE_IN_TOTO_PAYLOAD_TYPE,
      payload: Buffer.alloc(SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES + 1).toString("base64"),
      signatures: [{ keyid: "warden-attestation-key-1", sig: Buffer.alloc(64).toString("base64") }],
    };
    await expect(verifySoftwareAttestation({
      envelope: oversized,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_payload_too_large");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("verifies the signature before rejecting a signed non-canonical statement", async () => {
    const { privateKey, trustPolicy } = cryptoFixture();
    const statement = structuredClone(createSoftwareAttestationStatementV1(statementInput())) as unknown as {
      predicate: { scope: { sourceArtifacts: SoftwareAttestationExpectedScope["sourceArtifacts"] } };
    };
    statement.predicate.scope.sourceArtifacts.reverse();
    const bytes = Buffer.from(JSON.stringify(statement), "utf8");
    const envelope = signedEnvelopeForPayload(bytes, privateKey);

    await expect(verifySoftwareAttestation({
      envelope,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    })).rejects.toThrow("software_attestation_statement_noncanonical");
  });

  it("does not expose signer-owned aliases in the envelope", async () => {
    const { privateKey } = cryptoFixture();
    const signature = new Uint8Array(64);
    const signer: SoftwareAttestationSigner = {
      keyId: "warden-attestation-key-1",
      algorithm: "ed25519",
      sign(bytes) {
        signature.set(signBytes(null, bytes, privateKey));
        return signature;
      },
    };
    const envelope = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      signer,
    );
    const signedValue = envelope.signatures[0]!.sig;
    signature.fill(0);
    expect(envelope.signatures[0]!.sig).toBe(signedValue);
  });

  it("snapshots each injected port method once before invoking it", async () => {
    const fixture = cryptoFixture();
    let signReads = 0;
    let resolveReads = 0;
    let publicKeyReads = 0;
    let revokedAtReads = 0;
    const trusted = (await fixture.trustPolicy.resolve!("warden-attestation-key-1"))!;
    const returnedKey = new Proxy(trusted, {
      get(target, property, receiver) {
        if (property === "publicKey") publicKeyReads += 1;
        if (property === "revokedAt") revokedAtReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const signer = new Proxy(fixture.signer, {
      get(target, property, receiver) {
        if (property === "sign") signReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const trustPolicy = new Proxy({ resolve: async () => returnedKey }, {
      get(target, property, receiver) {
        if (property === "resolve") resolveReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const envelope = await signSoftwareAttestation(
      createSoftwareAttestationStatementV1(statementInput()),
      signer,
    );
    await verifySoftwareAttestation({
      envelope,
      trustPolicy,
      expectedScope: expectedScope(),
      verifiedAt,
    });

    expect(signReads).toBe(1);
    expect(resolveReads).toBe(1);
    expect(publicKeyReads).toBe(1);
    expect(revokedAtReads).toBe(1);
  });
});
