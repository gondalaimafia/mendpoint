import { describe, expect, it } from "vitest";
import {
  changeSubjectDigest,
  evaluatePrGates,
  evaluateSecurityAttestation,
  securityAttestationPolicyFromEnv,
  type SecurityScanAttestation,
} from "./index.js";

const OLD_SPEC = { openapi: "3.0.0", info: { title: "A", version: "1" }, paths: {} };
const NEW_SPEC = {
  openapi: "3.0.0",
  info: { title: "A", version: "2" },
  paths: { "/v1/x": { get: { responses: { "200": { description: "ok" } } } } },
};
const SUBJECT = changeSubjectDigest(OLD_SPEC, NEW_SPEC);
const NOW = "2026-08-14T12:00:00.000Z";

function claim(
  over: Partial<SecurityScanAttestation> = {},
): SecurityScanAttestation {
  return {
    tier: "claim",
    principal: "alice@example.com",
    attestedAt: "2026-08-14T11:00:00.000Z",
    subject: { algo: "sha256", digest: SUBJECT },
    ...over,
  } as SecurityScanAttestation;
}

function scanner(
  over: Partial<SecurityScanAttestation> = {},
): SecurityScanAttestation {
  return {
    tier: "scanner",
    principal: "ci-bot",
    attestedAt: "2026-08-14T11:00:00.000Z",
    subject: { algo: "sha256", digest: SUBJECT },
    tool: { name: "scanalot", version: "3.2.1" },
    evidenceRef: "s3://evidence/scan-123.json",
    ...over,
  } as SecurityScanAttestation;
}

describe("changeSubjectDigest", () => {
  it("is stable across key ordering (reproducible by an attester)", () => {
    const reordered = { paths: NEW_SPEC.paths, info: NEW_SPEC.info, openapi: "3.0.0" };
    expect(changeSubjectDigest(OLD_SPEC, reordered)).toBe(SUBJECT);
  });

  it("differs for a different change", () => {
    expect(changeSubjectDigest(OLD_SPEC, OLD_SPEC)).not.toBe(SUBJECT);
  });
});

describe("evaluateSecurityAttestation subject binding (replay)", () => {
  it("rejects an attestation minted for a different change", () => {
    const forOtherChange = claim({
      subject: { algo: "sha256", digest: changeSubjectDigest(OLD_SPEC, OLD_SPEC) },
    });
    const out = evaluateSecurityAttestation({
      attestation: forOtherChange,
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.satisfied).toBe(false);
    expect(out.code).toBe("subject_mismatch");
  });

  it("accepts an attestation bound to the change under gate", () => {
    const out = evaluateSecurityAttestation({
      attestation: claim(),
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.satisfied).toBe(true);
    expect(out.code).toBe("valid_claim");
  });

  it("fails closed when the change subject cannot be computed", () => {
    const out = evaluateSecurityAttestation({
      attestation: claim(),
      expectedSubjectDigest: undefined,
      now: NOW,
    });
    expect(out.satisfied).toBe(false);
    expect(out.code).toBe("subject_unverifiable");
  });
});

describe("evaluateSecurityAttestation expiry", () => {
  it("rejects an expired attestation", () => {
    const out = evaluateSecurityAttestation({
      attestation: claim({ expiresAt: "2026-08-14T11:59:59.000Z" }),
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.satisfied).toBe(false);
    expect(out.code).toBe("expired");
  });

  it("accepts a non-expired attestation", () => {
    const out = evaluateSecurityAttestation({
      attestation: claim({ expiresAt: "2026-08-14T12:00:01.000Z" }),
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.satisfied).toBe(true);
  });
});

describe("evaluateSecurityAttestation tiers", () => {
  it("a bare claim never reaches verified", () => {
    const out = evaluateSecurityAttestation({
      attestation: claim(),
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.verified).toBe(false);
    expect(out.tier).toBe("claim");
  });

  it("a caller-supplied scanner result is recorded but NOT verified without a platform check", () => {
    const out = evaluateSecurityAttestation({
      attestation: scanner(),
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    // Under a claim-tier (default) policy it satisfies the gate, but `verified`
    // reflects a platform check that did not happen — the tier label alone can
    // never produce it.
    expect(out.satisfied).toBe(true);
    expect(out.verified).toBe(false);
    expect(out.tier).toBe("scanner");
    expect(out.tool).toEqual({ name: "scanalot", version: "3.2.1" });
    expect(out.evidenceRef).toBe("s3://evidence/scan-123.json");
    expect(out.detail).toMatch(/NOT independently verified/i);
  });

  it("no request body alone can produce verified: true — a matching principal without an evidence check is not enough", () => {
    const out = evaluateSecurityAttestation({
      attestation: scanner({ principal: "ci-bot" }),
      expectedSubjectDigest: SUBJECT,
      // The platform bound the principal but no evidence dereference is wired.
      expectedPrincipal: "ci-bot",
      now: NOW,
    });
    expect(out.verified).toBe(false);
  });

  it("a scanner result the platform verifies (principal-bound + evidence dereferenced) IS verified", () => {
    const seen: unknown[] = [];
    const out = evaluateSecurityAttestation({
      attestation: scanner({ principal: "ci-bot" }),
      expectedSubjectDigest: SUBJECT,
      expectedPrincipal: "ci-bot",
      verifyEvidence: (verifyInput) => {
        seen.push(verifyInput);
        return verifyInput.evidenceRef === "s3://evidence/scan-123.json";
      },
      now: NOW,
    });
    expect(out.verified).toBe(true);
    expect(out.satisfied).toBe(true);
    expect(out.code).toBe("valid_scanner");
    // The platform hook received the exact evidence reference and subject binding.
    expect(seen).toEqual([
      {
        evidenceRef: "s3://evidence/scan-123.json",
        subjectDigest: SUBJECT,
        principal: "ci-bot",
        tool: { name: "scanalot", version: "3.2.1" },
      },
    ]);
  });

  it("a scanner result minted in a principal the request was not authenticated as is not verified", () => {
    const out = evaluateSecurityAttestation({
      attestation: scanner({ principal: "attacker" }),
      expectedSubjectDigest: SUBJECT,
      expectedPrincipal: "ci-bot",
      verifyEvidence: () => true,
      now: NOW,
    });
    expect(out.verified).toBe(false);
  });

  it("fails closed when the platform evidence resolver throws", () => {
    const out = evaluateSecurityAttestation({
      attestation: scanner({ principal: "ci-bot" }),
      expectedSubjectDigest: SUBJECT,
      policy: securityAttestationPolicyFromEnv({
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      }),
      expectedPrincipal: "ci-bot",
      verifyEvidence: () => {
        throw new Error("evidence store unavailable");
      },
      now: NOW,
    });

    expect(out.satisfied).toBe(false);
    expect(out.verified).toBe(false);
    expect(out.code).toBe("policy_insufficient");
  });

  it("rejects a scanner attestation missing tool identity as malformed", () => {
    const bad = scanner({ tool: undefined as never });
    const out = evaluateSecurityAttestation({
      attestation: bad,
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.satisfied).toBe(false);
    expect(out.code).toBe("malformed");
  });

  it("rejects a malformed subject digest", () => {
    const bad = claim({ subject: { algo: "sha256", digest: "not-a-digest" } });
    const out = evaluateSecurityAttestation({
      attestation: bad,
      expectedSubjectDigest: SUBJECT,
      now: NOW,
    });
    expect(out.code).toBe("malformed");
  });
});

describe("securityAttestationPolicyFromEnv (profile-driven)", () => {
  it("non-customer profile keeps today's behaviour (claim tier)", () => {
    expect(securityAttestationPolicyFromEnv({ MENDPOINT_DEPLOYMENT_PROFILE: "demo" })).toEqual({
      requiredTier: "claim",
      downgradeApplied: false,
      source: "default",
    });
  });

  it("keys on PROFILE, not CLASS — the live CLASS=customer/PROFILE=demo app stays on claim", () => {
    const policy = securityAttestationPolicyFromEnv({
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_DEPLOYMENT_PROFILE: "demo",
    });
    expect(policy.requiredTier).toBe("claim");
    expect(policy.source).toBe("default");
  });

  it("customer profile requires verified by default", () => {
    const policy = securityAttestationPolicyFromEnv({
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
    });
    expect(policy).toEqual({
      requiredTier: "scanner",
      downgradeApplied: false,
      source: "customer_profile",
    });
  });

  it("explicit require-verified flag on a non-customer profile", () => {
    const policy = securityAttestationPolicyFromEnv({
      MENDPOINT_DEPLOYMENT_PROFILE: "pilot",
      MENDPOINT_SECURITY_ATTESTATION_REQUIRE_VERIFIED: "1",
    });
    expect(policy.requiredTier).toBe("scanner");
    expect(policy.source).toBe("require_verified_flag");
  });

  it("operator override downgrades a customer profile and records it", () => {
    const policy = securityAttestationPolicyFromEnv({
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED: "1",
    });
    expect(policy).toEqual({
      requiredTier: "claim",
      downgradeApplied: true,
      source: "operator_override",
    });
  });

  it("a malformed override fails closed (require-verified stays)", () => {
    const policy = securityAttestationPolicyFromEnv({
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED: "yes-please",
    });
    expect(policy.requiredTier).toBe("scanner");
    expect(policy.source).toBe("customer_profile");
  });
});

describe("evaluatePrGates security policy integration", () => {
  const gateInput = {
    oldSpec: OLD_SPEC,
    newSpec: NEW_SPEC,
    contractCases: [
      { id: "a", name: "a", requiredKeys: ["x"], responseBody: { x: 1 } },
    ],
    now: NOW,
  };

  it("policy requiring verified BLOCKS a bare boolean and fails delivery", () => {
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttested: true,
      securityAttestationPolicy: securityAttestationPolicyFromEnv({
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      }),
    });
    expect(r.ok).toBe(false);
    const sec = r.gates.find((g) => g.id === "security-scan");
    expect(sec?.ok).toBe(false);
    expect(sec?.detail).toMatch(/policy requires a verified scanner result/i);
  });

  it("policy requiring verified BLOCKS a bare structured claim", () => {
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttestation: claim(),
      securityAttestationPolicy: securityAttestationPolicyFromEnv({
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.gates.find((g) => g.id === "security-scan")?.ok).toBe(false);
  });

  it("the customer-profile require-verified policy cannot be satisfied by a caller-supplied scanner string", () => {
    // A well-formed, subject-bound scanner attestation typed into the request
    // body does NOT satisfy require-verified, because the pipeline never
    // dereferenced its evidence — it fails closed, unverified.
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttestation: scanner(),
      securityAttestationPolicy: securityAttestationPolicyFromEnv({
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      }),
    });
    expect(r.ok).toBe(false);
    const sec = r.gates.find((g) => g.id === "security-scan");
    expect(sec?.ok).toBe(false);
    expect(sec?.verified).toBe(false);
    expect(r.attestation.code).toBe("policy_insufficient");
    expect(sec?.detail).toMatch(/not independently verified/i);
  });

  it("the require-verified policy is satisfied only by a platform-verified scanner result", () => {
    // Same policy, but the platform verifies the scanner result directly (the
    // gate does not thread a verifier, so this is asserted at the evaluator).
    const out = evaluateSecurityAttestation({
      attestation: scanner({ principal: "ci-bot" }),
      expectedSubjectDigest: SUBJECT,
      policy: securityAttestationPolicyFromEnv({ MENDPOINT_DEPLOYMENT_PROFILE: "customer" }),
      expectedPrincipal: "ci-bot",
      verifyEvidence: () => true,
      now: NOW,
    });
    expect(out.satisfied).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.code).toBe("valid_scanner");
  });

  it("customer profile + operator override accepts a bare claim and records the downgrade in evidence", () => {
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttested: true,
      securityAttestationPolicy: securityAttestationPolicyFromEnv({
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
        MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED: "1",
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.attestation.downgradeApplied).toBe(true);
    expect(r.attestation.satisfied).toBe(true);
    // The reviewer must see plainly that a weaker tier was accepted under override.
    expect(r.reportMarkdown).toMatch(/operator override/i);
    expect(r.gates.find((g) => g.id === "security-scan")?.detail).toMatch(
      /accepted under operator override/i,
    );
  });

  it("records the operator downgrade when an unverified scanner assertion is accepted", () => {
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttestation: scanner(),
      securityAttestationPolicy: securityAttestationPolicyFromEnv({
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
        MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED: "1",
      }),
    });

    expect(r.ok).toBe(true);
    expect(r.attestation.verified).toBe(false);
    expect(r.attestation.downgradeApplied).toBe(true);
    expect(r.reportMarkdown).toMatch(/operator override/i);
    expect(r.gates.find((gate) => gate.id === "security-scan")?.detail).toMatch(
      /accepted under operator override/i,
    );
  });

  it("a replayed structured attestation is rejected at the gate", () => {
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttestation: claim({
        subject: { algo: "sha256", digest: changeSubjectDigest(OLD_SPEC, OLD_SPEC) },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.gates.find((g) => g.id === "security-scan")?.detail).toMatch(
      /possible replay/i,
    );
  });

  it("renders attribution (who/when/subject/tier) for a structured attestation", () => {
    const r = evaluatePrGates({
      ...gateInput,
      securityScanAttestation: scanner(),
    });
    expect(r.reportMarkdown).toContain("**Security attestation**");
    expect(r.reportMarkdown).toContain("principal: ci-bot");
    expect(r.reportMarkdown).toContain("scanner: scanalot@3.2.1");
    expect(r.reportMarkdown).toContain(`subject: ${SUBJECT}`);
  });
});

describe("evaluatePrGates backwards compatibility (policy off)", () => {
  // A fixed pre-change expectation: with the default policy, an old-style
  // bare-boolean caller's gates and markdown are byte-identical to today.
  const legacyInput = {
    oldSpec: { openapi: "3.0.0", paths: {} },
    newSpec: { openapi: "3.0.0", paths: {} },
    contractCases: [
      { id: "a", name: "a", requiredKeys: ["x"], responseBody: { x: 1 } },
    ],
    securityScanOk: true,
  };

  it("old-style caller: gates + markdown unchanged", () => {
    const r = evaluatePrGates(legacyInput);
    expect(r.ok).toBe(true);
    expect(r.gates).toEqual([
      { id: "oas-breaking-change", ok: true, detail: "no breaking changes detected", verified: true },
      { id: "contract-suite", ok: true, detail: "contract suite passed", verified: true },
      {
        id: "security-scan",
        ok: true,
        detail:
          "attested by caller — NOT independently verified (no security scanner runs in this pipeline)",
        verified: false,
      },
    ]);
    expect(r.reportMarkdown).toBe(
      [
        "### Warden PR gates",
        "",
        "- ✅ **oas-breaking-change**: no breaking changes detected",
        "- ✅ **contract-suite**: contract suite passed",
        "- ✅ **security-scan** _(attested, not verified)_: attested by caller — NOT independently verified (no security scanner runs in this pipeline)",
        "",
        "> ⚠️ Gates marked _(attested, not verified)_ reflect a caller-supplied assertion, not a check this pipeline ran. Treat them as unverified.",
        "",
        "_All gates passed. Human review still required before merge._",
      ].join("\n"),
    );
    // No attribution block for the legacy path.
    expect(r.reportMarkdown).not.toContain("**Security attestation**");
  });

  it("bare boolean degrades to the weakest, explicitly unattributed tier", () => {
    const r = evaluatePrGates(legacyInput);
    expect(r.attestation.unattributed).toBe(true);
    expect(r.attestation.tier).toBe("claim");
    expect(r.attestation.verified).toBe(false);
  });
});
